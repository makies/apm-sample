<?php

namespace App\Http\Controllers;

use App\Models\Note;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Log;

class NoteController extends Controller
{
    public function index()
    {
        $notes = Note::orderByDesc('created_at')->limit(20)->get();
        Log::info('notes listed', ['count' => $notes->count()]);

        return response()->json(['items' => $notes]);
    }

    public function store(Request $request)
    {
        $text = $request->string('text')->isNotEmpty() ? $request->input('text') : 'untitled';
        $note = Note::create(['text' => $text]);
        Log::info('note created', ['noteId' => $note->id]);

        return response()->json(['note' => $note], 201);
    }
}
