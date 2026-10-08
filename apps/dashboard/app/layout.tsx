export const metadata = {
  title: "EmpTrack — Admin",
  description: "Employee monitoring admin dashboard",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          background: "#0b1220",
          color: "#e6edf7",
        }}
      >
        {children}
      </body>
    </html>
  );
}
