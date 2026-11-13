'use client';

// The Sedulia Social mark: a rounded square with the letter S, plain shapes and text so it needs no image file.
export const Logo = () => {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="60"
      height="60"
      viewBox="0 0 60 60"
      fill="none"
      className="mt-[8px] min-w-[60px] min-h-[60px]"
      role="img"
      aria-label="Sedulia Social"
    >
      <title>Sedulia Social</title>
      <rect x="8" y="8" width="44" height="44" rx="10" fill="#FFFFFF" />
      <text
        x="30"
        y="40"
        textAnchor="middle"
        fill="#0E0E0E"
        fontSize="30"
        fontWeight="700"
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
      >
        S
      </text>
    </svg>
  );
};
