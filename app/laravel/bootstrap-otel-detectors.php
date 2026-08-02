<?php

// Registers the ECS resource detector so zero-code instrumentation's
// default "all" detector set (OTEL_PHP_DETECTORS=all) picks it up via
// Registry::resourceDetectors(). Without this, spans carry service.name
// correctly but lack the aws.ecs.* resource attributes that Application
// Signals appears to key off of -- resulting in "UnknownService" in the
// curated view even though service.name is present.
// Loaded via composer.json's autoload.files, which Composer runs during
// the same vendor/autoload.php inclusion that triggers the opentelemetry
// extension's zero-code SDK bootstrap, so this must run early enough.
if (class_exists(\OpenTelemetry\Contrib\Aws\Ecs\Detector::class)
    && class_exists(\OpenTelemetry\SDK\Registry::class)
    && class_exists(\GuzzleHttp\Client::class)
) {
    \OpenTelemetry\SDK\Registry::registerResourceDetector('ecs', new \OpenTelemetry\Contrib\Aws\Ecs\Detector(
        new \OpenTelemetry\Contrib\Aws\Ecs\DataProvider(),
        new \GuzzleHttp\Client(),
        new \GuzzleHttp\Psr7\HttpFactory(),
    ));
}
