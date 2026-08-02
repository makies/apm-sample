# CloudWatch Application Signals APM サンプル

CloudWatch Application Signals(APM)を実際のECS Fargateワークロードで一通り体験するためのサンプル。
4つの言語/フレームワークの組み合わせで、サービスマップ・分散トレーシング(X-Ray)・SLO・ログ相関まで一気通貫で試せる。

## アーキテクチャ

```
Browser --> ALB --> [frontend] --(Service Connect)--> [backend] --> DynamoDB
             |          (Hono)                          (Hono)  \--> https://api.github.com (外部依存の例)
             |
             +--> /nest/*    --> [nest]    (NestJS + Drizzle)   --> Aurora Serverless v2 (Postgres, 独立)
             |
             +--> /laravel/* --> [laravel] (Laravel + Eloquent) --> Aurora Serverless v2 (MySQL, 独立)
```

- **frontend**: `/` でシンプルなHTML UIを返し、ボタン操作でbackendの各APIをサーバー側からfetchで呼び出す。
- **backend**:
  - `GET/POST /api/items` — DynamoDBへの読み書き(AWS SDK呼び出しが自動計装される)
  - `GET /api/external` — 外部HTTPS API呼び出し(サービスマップ上でリモート依存として表示される)
  - `GET /api/flaky` — ランダムな遅延と約12%の確率でエラーを返すエンドポイント。SLOのバーンレートを実際に動かすためのもの。
- **nest**(NestJS + Drizzle): 他サービスとは連携しない完全独立サービス。`/nest/health`, `/nest/notes`(GET/POST)。専用のAurora Serverless v2 Postgresクラスタを持つ。
- **laravel**(Laravel + Eloquent): 同じく完全独立サービス。`/laravel/health`, `/laravel/notes`(GET/POST)。専用のAurora Serverless v2 MySQLクラスタを持つ。PHPにはADOT(AWS版OpenTelemetry)が存在しないため、素のOpenTelemetry PHP SDK + Transaction Search(後述)でApplication Signals対応している。
- frontend/backendはECS Fargate + Service Connect(Cloud Map)でサービス間通信。nest/laravelはService Connectに参加せず、ALBのパスルーティング(`/nest/*`, `/laravel/*`)のみで到達可能。
- VPCはパブリックサブネット(ECSタスク用)+ Isolatedサブネット(Aurora用、NAT Gatewayなしで完全に非公開)の2構成。コスト削減のためECSタスクにパブリックIPを付与し、セキュリティグループで受信を絞る構成。本番ではプライベートサブネット+NAT推奨。
- DynamoDBへの通信はGateway VPCエンドポイント(無料)経由。
- Aurora Serverless v2(nest用Postgres、laravel用MySQLの2クラスタ)は最小0 ACUまでスケールダウンするため、アイドル時のコストはほぼゼロ。

## Application Signals の仕組み

### frontend / backend(Node.js, ADOT)

各タスクは3コンテナ構成:

1. `app` — Honoアプリ本体。`@aws/aws-distro-opentelemetry-node-autoinstrumentation` をnpm依存として組み込み、
   `NODE_OPTIONS=--require @aws/aws-distro-opentelemetry-node-autoinstrumentation/register` で自動計装を有効化(コード変更不要)。
2. `ecs-cwagent` — CloudWatch Agentのサイドカー。SSMパラメータ `ecs-cwagent` に入れた設定
   (`traces.traces_collected.application_signals` / `logs.metrics_collected.application_signals`)を読み込み、
   トレース・メトリクスをApplication Signalsへ転送する。
3. (Java/Python/.NETと違い)Node.jsはバイトコード注入用のinitコンテナやボリュームマウントが不要。npmパッケージをイメージに焼き込むだけでよい。

app コンテナは `http://localhost:4316/v1/traces` `http://localhost:4316/v1/metrics` へOTLPで送信し、
`ecs-cwagent` サイドカーがそれを受け取ってApplication Signals / X-Ray / CloudWatchへ中継する
(同一タスク内=`awsvpc`ネットワーク namespace共有のため`localhost`で届く)。nest(NestJS)も同じADOTパターン。

参考: [Deploy using the sidecar strategy](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Application-Signals-ECS-Sidecar.html)

### エンドポイント粒度(`OTEL_AWS_HTTP_OPERATION_PATHS`)

Application Signalsはデフォルトで、HTTPオペレーション名をURLパスの**先頭セグメントだけ**に丸める
(`/api/items` も `/api/flaky` も `GET /api` という1つの指標にまとめられる)。個別エンドポイントごとの
可用性・レイテンシを見るには、`OTEL_AWS_HTTP_OPERATION_PATHS` 環境変数に実際のパスを列挙する必要がある
(このスタックでは `infra/lib/apm-sample-stack.ts` で設定済み)。ADOTを使うfrontend/backend/nestにのみ有効な仕組み。
参考: [Configure HTTP endpoint visibility](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Application-Signals-EndpointVisibility.html)

### laravel(PHP、ADOTなし + Transaction Search)

PHPにはADOTディストリビューションが存在しないため、標準のOpenTelemetry PHP SDK(zero-code instrumentation、
`opentelemetry` PECL拡張)を使う。Application Signals対応には**Transaction Search**(アカウント全体のトレース取り込み方式)
の有効化が必須(`scripts/enable-transaction-search.sh`)。全スパンがCloudWatch Logsの`aws/spans`ロググループに
取り込まれ、そこからApplication Signalsの体験がサーバーサイドで生成される。

- ログ↔トレース相関は自動化されていない(Winston/Pino/Bunyanと違いMonologの自動計装は無い)ため、
  `app/Logging/TraceContextProcessor.php` で手動実装(`trace_id`/`span_id`をログに注入)。
- `open-telemetry/contrib-aws` のECSリソース検出器を `bootstrap-otel-detectors.php`
  (composerの`autoload.files`経由)で手動登録。これが無いとルートスパンの`aws.local.service`が
  `UnknownService`になる(子スパンは登録後も`UnknownService`のままで、これはAWS側のパイプラインの制約と見られる)。
- サーバーは`php artisan serve`ではなく`php:8.3-apache`(mod_php)を使用。開発用サーバー(`artisan serve`)は
  OTel拡張との組み合わせでリクエスト後にプロセスごと落ちる不具合があったため。

参考: [PHP zero-code instrumentation](https://opentelemetry.io/docs/zero-code/php/), [Transaction Search](https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/CloudWatch-Transaction-Search.html)

## 前提

- Node.js 20+ / npm
- Docker Desktop(イメージビルド用、起動しておくこと)
- AWS CLI v2、認証済みであること(`aws sts get-caller-identity` が通ること)
- 初回のみ: `cdk bootstrap`(`scripts/deploy.sh` が自動実行する)

## デプロイ手順

```bash
# 1. インフラ+アプリを一括デプロイ(Dockerイメージのビルド・ECRプッシュ・CFnデプロイまで)
./scripts/deploy.sh

# 2. アカウント全体でApplication Signals(ADOT系サービス用)とTransaction Search(PHP用)を有効化
#    (どちらも初回のみ、リージョン単位)
./scripts/enable-application-signals.sh
./scripts/enable-transaction-search.sh

# 3. トレース/メトリクスが貯まるようトラフィックを流す(3分間)
./scripts/generate-traffic.sh

# 4. backendの `/api/flaky` オペレーションに対してSLO(可用性・レイテンシ)を作成
#    ※ traffic生成から数分待って、Application Signalsにオペレーションが
#      表示されるようになってから実行すること
./scripts/create-slos.sh
```

デプロイ完了後、`./scripts/deploy.sh` の出力(CloudFormation Outputs)に表示される `SiteUrl` にブラウザでアクセスするとUIが見える。
`NestUrl`/`LaravelUrl` もそれぞれのヘルスチェックURLとして出力される。

## 見るべき場所(CloudWatchコンソール)

- **Application Signals > Services** — サービスマップ、レイテンシ/可用性/エラー率(4サービス全て)
  https://console.aws.amazon.com/cloudwatch/home#application-signals/services
- **Application Signals > SLOs** — `create-slos.sh` で作成したSLOの残エラーバジェット
  https://console.aws.amazon.com/cloudwatch/home#application-signals/slos
- **X-Ray > Traces** — frontend→backend→DynamoDB/外部API、nest→Postgres、laravel→MySQLの分散トレース
- 各サービスのCloudWatch Logsロググループ: `/ecs/apm-sample/{frontend,backend,nest,laravel}`
  (`aws.log.group.names` を設定しているため、Application SignalsのトレースからログへドリルダウンできるMetric-to-Logs相関が有効)
- **CloudWatch Logs > `aws/spans`** — Transaction Search経由で取り込まれる全スパン(laravelの生データはここで検索できる)

## コストについて

このサンプルは常時課金対象のリソースを作成する(目安、東京リージョン):

- Application Load Balancer: 常時起動 (~$16/月 + LCU)
- Fargateタスク x4 (frontend/backend/nest/laravel, 0.25vCPU/0.5GB): 常時起動 (~数ドル/月)
- Aurora Serverless v2 x2(nest用Postgres、laravel用MySQL): 最小0 ACUまでスケールダウンするためアイドル時はほぼ無料。ただしクラスタ自体のストレージ課金は常時発生
- DynamoDB: オンデマンド課金、この規模の検証では実質無料
- CloudWatch(メトリクス/ログ/トレース): 使用量課金、この規模なら少額

**確認が終わったら忘れずに `./scripts/destroy.sh` で削除すること。**
SLOはCDKスタックの外(Application Signals独自リソース)なので、`cdk destroy`では消えない。
`destroy.sh` 実行後のメッセージに従い、`aws application-signals delete-service-level-objective` で個別に削除する。
Transaction Searchはアカウント全体のトレース設定なので、`cdk destroy`後も有効なまま残る(元に戻したい場合は
`aws xray update-trace-segment-destination --destination XRay` で戻せる)。

## ディレクトリ構成

```
app/frontend/   Hono frontend (Dockerfile込み)
app/backend/    Hono backend (DynamoDB, 外部API, flakyエンドポイント)
app/nest/       NestJS + Drizzle backend (独立、Aurora Postgres)
app/laravel/    Laravel + Eloquent backend (独立、Aurora MySQL、ADOTなし)
infra/          AWS CDK (TypeScript) — VPC, ECS, ALB, DynamoDB, Aurora x2, Application Signals配線
scripts/        デプロイ/有効化/トラフィック生成/SLO作成/削除スクリプト
```
