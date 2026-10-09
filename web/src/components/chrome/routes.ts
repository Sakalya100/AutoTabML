/** Routes that are apps (their own scroll panes, a fixed-height grid): no Lenis, no hiding header, no grain. */
export const APP_ROUTES = /^\/(s|sign-in|sign-up)(\/|$)/;

export const isAppRoute = (pathname: string | null | undefined) => APP_ROUTES.test(pathname ?? "/");
