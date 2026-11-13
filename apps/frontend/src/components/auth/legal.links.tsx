import { FC } from 'react';

// Terms of Service and Privacy Policy links, from configuration (TERMS_URL and PRIVACY_URL, read by the server layout at
// request time). There is no built-in address: a link that is not configured, or is not an absolute http(s) address,
// is not shown. Same guard as SOURCE_CODE_URL (apps/frontend/src/components/layout/source.code.link.tsx).
export const legalHref = (url?: string | null): string | null => {
  const value = (url ?? '').trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? value : null;
  } catch {
    return null;
  }
};

export const LegalLinks: FC<{ terms?: string | null; privacy?: string | null }> = ({ terms, privacy }) => {
  const links = [
    { href: legalHref(terms), label: 'Terms of Service' },
    { href: legalHref(privacy), label: 'Privacy Policy' },
  ].filter((l): l is { href: string; label: string } => !!l.href);

  if (links.length === 0) {
    return null;
  }

  return (
    <div className="flex gap-[16px] justify-center text-[12px] text-[#D1D1D1]">
      {links.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer" className="underline hover:font-bold">
          {l.label}
        </a>
      ))}
    </div>
  );
};
