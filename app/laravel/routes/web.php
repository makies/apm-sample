<?php

use App\Http\Controllers\NoteController;
use Illuminate\Support\Facades\Route;

// Path-prefixed so the ALB can route "/laravel/*" to this service on the
// same load balancer as the other services, without needing its own ALB.
Route::prefix('laravel')->group(function () {
    Route::get('/health', fn () => response()->json(['status' => 'ok']));
    Route::get('/notes', [NoteController::class, 'index']);
    Route::post('/notes', [NoteController::class, 'store']);
});
