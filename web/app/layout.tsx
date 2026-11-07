import type { Metadata, Viewport } from 'next';
import { Be_Vietnam_Pro, JetBrains_Mono } from 'next/font/google';
import './globals.css';

const ui = Be_Vietnam_Pro({ subsets: ['latin', 'vietnamese'], weight: ['400', '500', '600', '700'], variable: '--font-ui' });
const code = JetBrains_Mono({ subsets: ['latin'], weight: ['400', '500'], variable: '--font-code' });

export const metadata: Metadata = {
  title: 'Conference AI Copilot',
  description: 'Dịch hội nghị đa ngôn ngữ sang tiếng Việt theo thời gian thực',
};

export const viewport: Viewport = { themeColor: '#05080f', width: 'device-width', initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="vi" className={`${ui.variable} ${code.variable}`}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
