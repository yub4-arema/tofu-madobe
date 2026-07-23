import "./globals.css";

export const metadata = {
  title: "tofu-madobe",
  description: "小窓で常駐する音声対話AItuber",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ja" className="font-sans antialiased">
      <body>{children}</body>
    </html>
  );
}
