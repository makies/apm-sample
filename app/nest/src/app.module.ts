import { Controller, Get, Module } from '@nestjs/common'
import { DbModule } from './db/db.module'
import { NotesModule } from './notes/notes.module'

@Controller()
class HealthController {
  @Get('health')
  health() {
    return { status: 'ok' }
  }
}

@Module({
  imports: [DbModule, NotesModule],
  controllers: [HealthController],
})
export class AppModule {}
