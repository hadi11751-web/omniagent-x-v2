import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// The Stripe webhook must stay public (Stripe calls it directly, with no
// user session), and Clerk's own sign-in/up pages obviously can't require
// being signed in already.
const isPublicRoute = createRouteMatcher(["/sign-in(.*)", "/sign-up(.*)", "/api/stripe/webhook"]);

export default clerkMiddleware(async (auth, request) => {
  if (!isPublicRoute(request)) {
    await auth.protect();
  }
});

export const config = {
  matcher: ["/((?!_next|.*\\..*).*)", "/(api|trpc)(.*)"],
};

