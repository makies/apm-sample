<?php

namespace App\Logging;

use Monolog\LogRecord;
use Monolog\Processor\ProcessorInterface;
use OpenTelemetry\API\Trace\Span;

// PHP has no auto-instrumentation for Monolog (unlike Winston for Node),
// so trace_id/span_id have to be added by hand. Mirrors what ADOT does
// automatically for the other services in this sample.
class TraceContextProcessor implements ProcessorInterface
{
    public function __invoke(LogRecord $record): LogRecord
    {
        $context = Span::getCurrent()->getContext();
        if (! $context->isValid()) {
            return $record;
        }

        return $record->with(extra: [
            ...$record->extra,
            'trace_id' => $context->getTraceId(),
            'span_id' => $context->getSpanId(),
        ]);
    }
}
