// The sign-in pages are Sedulia Social's: its name, no Postiz marketing panel (testimonials, avatars, "20,000+" user count),
// no postiz.com link, and the Terms and Privacy links from configuration, never a hard coded address.
// Pure render tests in the node environment, as source.code.link.spec.ts does. Run from the repository root:
//   pnpm exec jest -c apps/frontend/jest.config.cjs
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// apps/frontend/jest.config.cjs has no @gitroom path map (and this change leaves it alone), so the layout's aliased imports are
// registered as virtual mocks: the framework pieces as stubs, the two Sedulia components as the real files.
jest.mock(
  '@gitroom/react/translation/get.translation.service.backend',
  () => ({ getT: async () => (_key: string, fallback: string) => fallback }),
  { virtual: true }
);
jest.mock('next/dynamic', () => () => () => null);
jest.mock('@gitroom/react/helpers/mantine.wrapper', () => ({ MantineWrapper: ({ children }: any) => children }), { virtual: true });
jest.mock('@gitroom/react/toaster/toaster', () => ({ Toaster: () => null }), { virtual: true });
jest.mock('@gitroom/frontend/components/ui/logo-text.component', () => jest.requireActual('../ui/logo-text.component'), { virtual: true });
jest.mock('@gitroom/frontend/components/auth/legal.links', () => jest.requireActual('./legal.links'), { virtual: true });

import AuthLayout from '../../app/(app)/auth/layout';
import { LegalLinks, legalHref } from './legal.links';
import { LogoTextComponent } from '../ui/logo-text.component';
import { Logo } from '../new-layout/logo';

const FRONTEND = join(__dirname, '..', '..', '..');
const AUTH_COMPONENTS = join(FRONTEND, 'src', 'components', 'auth');
const AUTH_APP = join(FRONTEND, 'src', 'app', '(app)', 'auth');
const PUBLIC = join(FRONTEND, 'public');

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

const ENV = ['TERMS_URL', 'PRIVACY_URL'];
let saved: Record<string, string | undefined>;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  delete process.env.TERMS_URL;
  delete process.env.PRIVACY_URL;
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const MARKETING = [/postiz/i, /gitroom/i, /testimonial/i, /20,000/, /entrepreneurs/i, /avatar/i, /<img/i, /marquee/i];

async function renderLayout() {
  const tree = await AuthLayout({ children: createElement('div', null, 'THE FORM') });
  return renderToStaticMarkup(tree as any);
}

describe('the auth layout every sign-in page sits in', () => {
  it('names Sedulia Social and renders the page it wraps', async () => {
    const html = await renderLayout();
    expect(html).toContain('Sedulia Social');
    expect(html).toContain('THE FORM');
  });

  it('carries no Postiz marketing: no testimonial, avatar, user count, image or postiz.com link', async () => {
    const html = await renderLayout();
    for (const rx of MARKETING) {
      expect(html).not.toMatch(rx);
    }
  });
});

describe('the logos', () => {
  it('the wordmark says Sedulia Social and nothing of Postiz', () => {
    const html = renderToStaticMarkup(createElement(LogoTextComponent));
    expect(html).toContain('Sedulia Social');
    expect(html).not.toMatch(/postiz/i);
  });

  it('the mark is Sedulia Social\'s and carries no Postiz text', () => {
    const html = renderToStaticMarkup(createElement(Logo));
    expect(html).toContain('Sedulia Social');
    expect(html).not.toMatch(/postiz/i);
  });
});

describe('Terms and Privacy links come from configuration', () => {
  it('shows exactly the configured addresses', async () => {
    process.env.TERMS_URL = 'https://social.example/terms';
    process.env.PRIVACY_URL = 'https://social.example/privacy';
    const html = await renderLayout();
    expect(html).toContain('href="https://social.example/terms"');
    expect(html).toContain('href="https://social.example/privacy"');
    expect(html).toContain('Terms of Service');
    expect(html).toContain('Privacy Policy');
    expect(html).not.toMatch(/postiz/i);
  });

  it('shows no link at all while a variable is unset: there is no hard coded fallback', async () => {
    expect(await renderLayout()).not.toMatch(/Terms of Service|Privacy Policy/);
    process.env.TERMS_URL = 'https://social.example/terms';
    const html = await renderLayout();
    expect(html).toContain('Terms of Service');
    expect(html).not.toContain('Privacy Policy');
  });

  it('refuses anything that is not an absolute http(s) address', () => {
    for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,x', '//evil.example/x', '/relative', 'not a url', '', '   ', undefined]) {
      expect(legalHref(bad)).toBeNull();
      expect(renderToStaticMarkup(createElement(LegalLinks, { terms: bad, privacy: bad }))).toBe('');
    }
  });

  it('opens in a new tab without handing the page to the target', () => {
    const html = renderToStaticMarkup(createElement(LegalLinks, { terms: 'https://a.example/t', privacy: 'https://a.example/p' }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it('is read at request time by the server layout, from TERMS_URL and PRIVACY_URL', () => {
    const layout = readFileSync(join(AUTH_APP, 'layout.tsx'), 'utf8');
    expect(layout).toContain('process.env.TERMS_URL');
    expect(layout).toContain('process.env.PRIVACY_URL');
  });
});

describe('what is gone from the sign-in code and assets', () => {
  const signInSources = [...walk(AUTH_COMPONENTS), ...walk(AUTH_APP)].filter(
    (f) => /\.(ts|tsx)$/.test(f) && !/\.spec\.ts$/.test(f) && !/farcaster\.provider\.tsx$/.test(f) // the Farcaster approval is a channel dialog, not a sign-in page
  );
  // a package name or an import alias (@postiz/wallets, @gitroom/...) is not copy
  const text = (f: string) => readFileSync(f, 'utf8').replace(/^.*@postiz\/.*$/gm, '').replace(/@gitroom\//g, '');

  it('has no testimonial component, helper or avatar picture left', () => {
    expect(existsSync(join(AUTH_COMPONENTS, 'testimonial.component.tsx'))).toBe(false);
    expect(existsSync(join(AUTH_COMPONENTS, 'testimonial.tsx'))).toBe(false);
    expect(existsSync(join(FRONTEND, '..', '..', 'libraries', 'react-shared-libraries', 'src', 'helpers', 'testomonials.tsx'))).toBe(false);
    expect(existsSync(join(PUBLIC, 'auth', 'avatars'))).toBe(false);
    for (const f of [...signInSources, join(FRONTEND, 'src', 'components', 'ui', 'logo-text.component.tsx')]) {
      expect(text(f)).not.toMatch(/testimonial|testomonials|auth\/avatars/i);
    }
  });

  it('names Postiz nowhere in the sign-in pages, and links to postiz.com nowhere', () => {
    expect(signInSources.length).toBeGreaterThan(10);
    const offenders = signInSources.filter((f) => /postiz|gitroom|20,000/i.test(text(f)));
    expect(offenders).toEqual([]);
  });

  it('titles every sign-in page Sedulia Social', () => {
    const pages = walk(AUTH_APP).filter((f) => /page\.tsx$/.test(f) && /export const metadata/.test(readFileSync(f, 'utf8')));
    expect(pages.length).toBeGreaterThanOrEqual(6);
    for (const f of pages) {
      expect(readFileSync(f, 'utf8')).toMatch(/title: `?['"]?Sedulia Social /);
    }
  });

  it('offers Google, Apple and email: no GitHub, wallet, Farcaster or generic OAuth button on the sign-in or register form', () => {
    for (const name of ['login.tsx', 'register.tsx']) {
      const src = readFileSync(join(AUTH_COMPONENTS, name), 'utf8');
      expect(src).toContain('GoogleProvider');
      expect(src).toContain('AppleProvider');
      expect(src).not.toMatch(/GithubProvider|WalletProvider|WalletUiProvider|FarcasterProvider|OauthProvider|genericOauth/);
    }
  });
});
