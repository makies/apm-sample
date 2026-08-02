import { Inject, Injectable } from '@nestjs/common'
import { desc } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { DRIZZLE } from '../db/db.module'
import { notes } from './schema'

@Injectable()
export class NotesService {
  constructor(@Inject(DRIZZLE) private readonly db: NodePgDatabase<Record<string, unknown>>) {}

  findAll() {
    return this.db.select().from(notes).orderBy(desc(notes.createdAt)).limit(20)
  }

  async create(text: string) {
    const [row] = await this.db.insert(notes).values({ text }).returning()
    return row
  }
}
