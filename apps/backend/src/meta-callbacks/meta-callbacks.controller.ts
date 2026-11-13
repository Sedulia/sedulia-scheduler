import { Body, Controller, Get, HttpCode, Param, Post, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { MetaCallbacksService } from '@gitroom/backend/meta-callbacks/meta-callbacks.service';

// Meta's callbacks (set in the app's console) and the page the deletion request's url points at.
// None of them is behind a login: Meta calls them, and what proves the caller is the signed_request.
//   POST /meta-callbacks/data-deletion   form field signed_request  ->  {url, confirmation_code}
//   POST /meta-callbacks/deauthorize     form field signed_request  ->  200
//   GET  /meta-callbacks/deletion-status/:code                      ->  a page saying pending or done
@ApiExcludeController()
@Controller('/meta-callbacks')
export class MetaCallbacksController {
  constructor(private _service: MetaCallbacksService) {}

  @Post('/data-deletion')
  @HttpCode(200)
  dataDeletion(@Body() body: any) {
    return this._service.dataDeletion(body?.signed_request);
  }

  @Post('/deauthorize')
  @HttpCode(200)
  deauthorize(@Body() body: any) {
    return this._service.deauthorize(body?.signed_request);
  }

  @Get('/deletion-status/:code')
  async status(@Param('code') code: string, @Res() res: Response) {
    const state = await this._service.status(code);
    res.set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Robots-Tag': 'noindex',
    });
    if (!state) {
      // one answer for a forged code, a code for nothing and a missing key
      return res.status(404).send(page('Not found', 'There is no deletion request for this address.'));
    }
    return res.status(200).send(
      state === 'done'
        ? page('Done', 'The data has been removed. We keep business records the law requires.')
        : page('Pending', 'We received the request. The data is removed within 30 days.')
    );
  }
}

// The words are fixed: the page never repeats anything a caller sent or anything about who asked.
const page = (heading: string, line: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
  `<meta name="viewport" content="width=device-width,initial-scale=1">` +
  `<meta name="robots" content="noindex"><title>Deletion request</title></head>` +
  `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem">` +
  `<h1>${heading}</h1><p>${line}</p></body></html>`;
