import { Heebo } from 'next/font/google';
import type { ReactNode } from 'react';
import './globals.css';

const heebo = Heebo({
  subsets: ['hebrew', 'latin'],
  variable: '--font-heebo',
  display: 'swap',
});

export const metadata = {
  title: 'ממש — קהילה · בית · משפחה',
  description: 'משחקייה פנים-עירונית ברמת השרון לגילאי 0–6',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={heebo.variable}>
      <body className="antialiased">{children}</body>
    </html>
  );
}
