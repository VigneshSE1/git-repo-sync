import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Git Repo Sync',
  description: 'Sync an org repository to an intern repository and transfer reviewed PRs back safely.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="font-sans">{children}</body>
    </html>
  );
}
