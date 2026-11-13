import { FC } from 'react';

// A visible "Source code" link for the AGPL section 13 offer. The operator sets SOURCE_CODE_URL (a runtime
// environment variable, not a build-time one) to the public place that holds the exact source of what runs,
// for example the tag of this build. With the variable unset, nothing renders and nothing changes for anyone
// who runs Postiz without it.
export const sourceCodeHref = (raw?: string | null): string | null => {
  const value = (raw || '').trim();
  if (!value) {
    return null;
  }
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return value;
  } catch {
    return null;
  }
};

export const SourceCodeLink: FC<{ url?: string | null }> = ({ url }) => {
  const href = sourceCodeHref(url);
  if (!href) {
    return null;
  }
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{
        position: 'fixed',
        right: 12,
        bottom: 8,
        zIndex: 40,
        fontSize: 12,
        opacity: 0.7,
        color: 'inherit',
        textDecoration: 'underline',
      }}
    >
      Source code
    </a>
  );
};
