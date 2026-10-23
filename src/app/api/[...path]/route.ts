import { dispatch } from '@/server/api';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

type Ctx = { params: Promise<{ path: string[] }> };

const handle = async (req: Request, ctx: Ctx) => dispatch(req, (await ctx.params).path);

export const GET = handle;
export const POST = handle;
export const PUT = handle;
