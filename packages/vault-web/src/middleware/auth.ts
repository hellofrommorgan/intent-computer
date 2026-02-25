/**
 * Auth middleware for exe.dev.
 *
 * exe.dev's HTTPS proxy injects X-ExeDev-UserID and X-ExeDev-Email headers
 * on authenticated requests. We use these to gate access:
 *
 * - If X-ExeDev-UserID is present → full vault access (owner)
 * - If absent → only public capsules (shared link visitors)
 */

import type { MiddlewareHandler } from "hono";

export interface AuthContext {
    userId: string | null;
    email: string | null;
    isOwner: boolean;
}

export type AppEnv = {
    Variables: {
        auth: AuthContext;
    };
};

export function authMiddleware(): MiddlewareHandler<AppEnv> {
    return async (c, next) => {
        const userId = c.req.header("x-exedev-userid") ?? null;
        const email = c.req.header("x-exedev-email") ?? null;

        const auth: AuthContext = {
            userId,
            email,
            isOwner: userId !== null,
        };

        c.set("auth", auth);
        await next();
    };
}
