import { ImageResponse } from 'next/og';

// Home-screen icon for iPhone ("Add to Home Screen").
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#05080f',
          color: '#3b6cff',
          fontSize: 92,
          fontWeight: 700,
          letterSpacing: -4,
        }}
      >
        CC
      </div>
    ),
    { ...size },
  );
}
