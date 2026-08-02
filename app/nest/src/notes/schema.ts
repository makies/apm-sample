import { pgTable, uuid, text, timestamp } from 'drizzle-orm/pg-core'

export const notes = pgTable('notes', {
  id: uuid('id').defaultRandom().primaryKey(),
  text: text('text').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
