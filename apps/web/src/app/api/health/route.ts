export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({
    status: 'ok',
    service: 'memesh-web',
    timestamp: new Date().toISOString(),
  });
}
