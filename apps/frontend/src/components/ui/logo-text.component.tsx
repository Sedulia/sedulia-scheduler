import React from 'react';

// The Sedulia Social wordmark, plain text so it needs no image file and scales with the page.
export const LogoTextComponent = () => {
  return (
    <svg
      width="220"
      height="36"
      viewBox="0 0 220 36"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Sedulia Social"
    >
      <title>Sedulia Social</title>
      <text
        x="0"
        y="27"
        fill="currentColor"
        fontSize="26"
        fontWeight="600"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
      >
        Sedulia Social
      </text>
    </svg>
  );
};
