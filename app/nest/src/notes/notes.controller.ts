import { Body, Controller, Get, Post } from '@nestjs/common'
import { logger } from '../logger'
import { NotesService } from './notes.service'

@Controller('notes')
export class NotesController {
  constructor(private readonly notesService: NotesService) {}

  @Get()
  async findAll() {
    const items = await this.notesService.findAll()
    logger.info('notes listed', { count: items.length })
    return { items }
  }

  @Post()
  async create(@Body() body: { text?: string }) {
    const text = typeof body?.text === 'string' && body.text.length > 0 ? body.text : 'untitled'
    const note = await this.notesService.create(text)
    logger.info('note created', { noteId: note.id })
    return { note }
  }
}
