import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import type { Request, Response, NextFunction } from 'express'
import { AppModule } from './app.module'
import { AllExceptionsFilter } from './all-exceptions.filter'
import { logger } from './logger'

async function bootstrap() {
  const app = await NestFactory.create(AppModule)

  // Path-prefixed so the ALB can route "/nest/*" to this service on the
  // same load balancer as frontend/backend, without needing its own ALB.
  app.setGlobalPrefix('nest')

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now()
    logger.info('request received', { method: req.method, path: req.path })
    res.on('finish', () => {
      logger.info('request completed', {
        method: req.method,
        path: req.path,
        status: res.statusCode,
        duration_ms: Date.now() - start,
      })
    })
    next()
  })

  app.useGlobalFilters(new AllExceptionsFilter())

  const port = Number(process.env.PORT ?? 8080)
  await app.listen(port)
  logger.info('nest listening', { port })
}

bootstrap()
