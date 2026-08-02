<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class LogRequests
{
    public function handle(Request $request, Closure $next)
    {
        $start = microtime(true);
        Log::info('request received', ['method' => $request->method(), 'path' => '/'.$request->path()]);

        $response = $next($request);

        Log::info('request completed', [
            'method' => $request->method(),
            'path' => '/'.$request->path(),
            'status' => $response->getStatusCode(),
            'duration_ms' => (int) round((microtime(true) - $start) * 1000),
        ]);

        return $response;
    }
}
