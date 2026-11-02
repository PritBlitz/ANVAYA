import { Controller, Get, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { constantTimeEqual } from '../common/crypto.js';
import { Errors } from '../common/errors.js';
import { RAW_RESPONSE } from '../common/http.js';
import { renderMetrics } from '../common/metrics.js';
import { AppConfig } from '../config/config.js';
import { Public } from '../identity/auth.decorators.js';

/** Prometheus metrics for operators. Disabled (404) unless METRICS_TOKEN is set; requires that bearer token. */
@Controller('internal')
export class MetricsController {
  constructor(private readonly config: AppConfig) {}

  @Public()
  @Get('metrics')
  metrics(@Req() req: Request, @Res() res: Response): symbol {
    const token = this.config.env.METRICS_TOKEN;
    if (!token) throw Errors.notFound('Route');
    const header = req.header('authorization') ?? '';
    if (!constantTimeEqual(header, `Bearer ${token}`)) throw Errors.unauthenticated();
    res.status(200).type('text/plain; version=0.0.4').send(renderMetrics());
    return RAW_RESPONSE;
  }
}
