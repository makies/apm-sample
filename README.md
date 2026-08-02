# CloudWatch Application Signals APM サンプル

CloudWatch Application Signals(APM)を実際のECS Fargateワークロードで一通り体験するためのサンプル。
Node.js(Hono)の2サービス構成で、サービスマップ・分散トレーシング(X-Ray)・SLOまで一気通貫で試せる。

## アーキテクチャ

```
Browser --> ALB --> [frontend service] --(Service Connect)--> [backend service] --> DynamoDB
                          (Hono)                                    (Hono)     \--> https://api.github.com (外部依存の例)
```

- **frontend**: `/` でシンプルなHTML UIを返し、ボタン操作でbackendの各APIをサーバー側からfetchで呼び出す。
- **backend**:
  - `GET/POST /api/items` — DynamoDBへの読み書き(AWS SDK呼び出しが自動計装される)
  - `GET /api/external` — 外部HTTPS API呼び出し(サービスマップ上でリモート依存として表示される)
  - `GET /api/flaky` — ランダムな遅延と約12%の確率でエラーを返すエンドポイント。SLOのバーンレートを実際に動かすためのもの。
- 2サービスとも ECS Fargate、`awsvpc`ネットワークモード、Service Connect(Cloud Map)でサービス間通信。
- VPCはパブリックサブネットのみ(NAT Gatewayなし)。コスト削減のためタスクにパブリックIPを付与し、セキュリティグループで受信を絞る構成。本番ではプライベートサブネット+NAT推奨。
- DynamoDBへの通信はGateway VPCエンドポイント(無料)経由。

## Application Signals の仕組み

各タスクは3コンテナ構成(frontend/backendとも同じパターン):

1. `app` — Honoアプリ本体。`@aws/aws-distro-opentelemetry-node-autoinstrumentation` をnpm依存として組み込み、
   `NODE_OPTIONS=--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register` で自動計装を有効化(コード変更不要)。
2. `ecs-cwagent` — CloudWatch Agentのサイドカー。SSMパラメータ `ecs-cwagent` に入れた設定
   (`traces.traces_collected.application_signals` / `logs.metrics_collected.application_signals`)を読み込み、
   トレース・メトリクスをApplication Signalsへ転送する。
3. (Java/Python/.NETと違い)Node.jsはバイトコード注入用のinitコンテナやボリュームマウントが不要。npmパッケージをイメージに焼き込むだけでよい。

app コンテナは `http://localhost:4316/v1/traces` `http://localhost:4316/v1/metrics` へOTLPで送信し、
`ecs-cwagent` サイドカーがそれを受け取ってApplication Signals / X-Ray / CloudWatchへ中継する
(同一タスク内=`awsvpc`ネットワーク namespace共有のため`localhost`で届く)。

参考: [Deploy using the sidecar strategy](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html)

### エンドポイント粒度(`OTEL_AWS_HTTP_OPERATION_PATHS`)

Application Signalsはデフォルトで、HTTPオペレーション名をURLパスの**先頭セグメントだけ**に丸める
(`/api/items` も `/api/flaky` も `GET /api` という1つの指標にまとめられる)。個別エンドポイントごとの
可用性・レイテンシを見るには、`OTEL_AWS_HTTP_OPERATION_PATHS` 環境変数に実際のパスを列挙する必要がある
(このスタックでは `infra/lib/apm-sample-stack.ts` で設定済み)。
参考: [Configure HTTP endpoint visibility](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Application-Signals-EndpointVisibility.html)

## 前提

- Node.js 20+ / npm
- Docker Desktop(イメージビルド用、起動しておくこと)
- AWS CLI v2、認証済みであること(`aws sts get-caller-identity` が通ること)
- 初回のみ: `cdk bootstrap`(`scripts/deploy.sh` が自動実行する)

## デプロイ手順

```bash
# 1. インフラ+アプリを一括デプロイ(Dockerイメージのビルド・ECRプッシュ・CFnデプロイまで)
./scripts/deploy.sh

# 2. アカウント全体でApplication Signalsの検出を有効化(初回のみ、リージョン単位)
./scripts/enable-application-signals.sh

# 3. トレース/メトリクスが貯まるようトラフィックを流す(3分間)
./scripts/generate-traffic.sh

# 4. backendの `/api/flaky` オペレーションに対してSLO(可用性・レイテンシ)を作成
#    ※ traffic生成から数分待って、Application Signalsにオペレーションが
#      表示されるようになってから実行すること
./scripts/create-slos.sh
```

デプロイ完了後、`./scripts/deploy.sh` の出力(CloudFormation Outputs)に表示される `SiteUrl` にブラウザでアクセスするとUIが見える。

## 見るべき場所(CloudWatchコンソール)

- **Application Signals > Services** — サービスマップ、レイテンシ/可用性/エラー率
  https://console.aws.amazon.com/cloudwatch/home#application-signals/services
- **Application Signals > SLOs** — `create-slos.sh` で作成したSLOの残エラーバジェット
  https://console.aws.amazon.com/cloudwatch/home#application-signals/slos
- **X-Ray > Traces** — frontend→backend→DynamoDB/外部APIの1本の分散トレース
- 各サービスのCloudWatch Logsロググループ: `/ecs/apm-sample/frontend`, `/ecs/apm-sample/backend`
  (`aws.log.group.names` を設定しているため、Application SignalsのトレースからログへドリルダウンできるMetric-to-Logs相関が有効)

## コストについて

このサンプルは常時課金対象のリソースを作成する(目安、東京リージョン):

- Application Load Balancer: 常時起動 (~$16/月 + LCU)
- Fargateタスク x2 (frontend/backend, 0.25vCPU/0.5GB): 常時起動 (~数ドル/月)
- DynamoDB: オンデマンド課金、この規模の検証では実質無料
- CloudWatch(メトリクス/ログ/トレース): 使用量課金、この規模なら少額

**確認が終わったら忘れずに `./scripts/destroy.sh` で削除すること。**
SLOはCDKスタックの外(Application Signals独自リソース)なので、`cdk destroy`では消えない。
`destroy.sh` 実行後のメッセージに従い、`aws application-signals delete-service-level-objective` で個別に削除する。

## ディレクトリ構成

```
app/frontend/   Hono frontend (Dockerfile込み)
app/backend/    Hono backend (DynamoDB, 外部API, flakyエンドポイント)
infra/          AWS CDK (TypeScript) — VPC, ECS, ALB, DynamoDB, Application Signals配線
scripts/        デプロイ/有効化/トラフィック生成/SLO作成/削除スクリプト
```
