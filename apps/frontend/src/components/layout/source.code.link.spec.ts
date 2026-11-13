import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  SourceCodeLink,
  sourceCodeHref,
} from './source.code.link';

const render = (url?: string) =>
  renderToStaticMarkup(createElement(SourceCodeLink, { url }));

describe('SOURCE_CODE_URL source link (AGPL section 13 offer)', () => {
  const tag = 'https://github.com/example-org/example-fork/tree/social-2026-11-01-abc1234';

  it('shows a Source code link to exactly the configured URL', () => {
    const html = render(tag);
    expect(html).toContain('>Source code</a>');
    expect(html).toContain(`href="${tag}"`);
  });

  it('renders nothing at all when the URL is not set', () => {
    expect(render(undefined)).toBe('');
    expect(render('')).toBe('');
    expect(render('   ')).toBe('');
  });

  it('refuses anything that is not an absolute http(s) URL', () => {
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>1</script>',
      '//evil.example/x',
      '/relative/path',
      'not a url',
      'ftp://example.org/x',
    ]) {
      expect(sourceCodeHref(bad)).toBeNull();
      expect(render(bad)).toBe('');
    }
  });

  it('opens in a new tab without handing the page to the target', () => {
    const html = render(tag);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('is wired into the app layout from the runtime variable, not a build-time one', () => {
    const layout = readFileSync(
      join(__dirname, '../../app/(app)/layout.tsx'),
      'utf8'
    );
    expect(layout).toContain('<SourceCodeLink url={process.env.SOURCE_CODE_URL}');
    expect(layout).not.toContain('NEXT_PUBLIC_SOURCE_CODE_URL');
  });
});
