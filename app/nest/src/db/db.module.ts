import { Global, Module, OnModuleInit, Inject } from '@nestjs/common'
import { Pool } from 'pg'
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres'
import * as schema from '../notes/schema'
import { logger } from '../logger'

export const DRIZZLE = 'DRIZZLE'
export const PG_POOL = 'PG_POOL'

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      useFactory: () =>
        new Pool({
          host: process.env.DB_HOST,
          port: Number(process.env.DB_PORT ?? 5432),
          user: process.env.DB_USER,
          password: process.env.DB_PASSWORD,
          database: process.env.DB_NAME,
          // Aurora Postgres accepts plain TCP too, but recent engine
          // versions default to requiring SSL -- this works either way.
          ssl: { rejectUnauthorized: false },
        }),
    },
    {
      provide: DRIZZLE,
      useFactory: (pool: Pool) => drizzle(pool, { schema }),
      inject: [PG_POOL],
    },
  ],
  exports: [DRIZZLE, PG_POOL],
})
export class DbModule implements OnModuleInit {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  // No migration pipeline for this demo -- just make sure the table this
  // sample needs exists on startup.
  async onModuleInit() {
    await this.pool.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS notes (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        text text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `)
    logger.info('database schema ready')
  }
}
