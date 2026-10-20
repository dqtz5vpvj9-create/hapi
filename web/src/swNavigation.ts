export function isAppNavigationRequest(
    { request, url }: { request: { mode?: string }; url: URL },
    origin: string,
    appRoot: string,
): boolean {
    return request.mode === 'navigate'
        && url.origin === origin
        && (url.pathname === appRoot || url.pathname === `${appRoot}index.html`)
}

export async function handleAppNavigation(
    context: any,
    navigation: { handle: (context: any) => Promise<Response> },
    matchPrecache: (url: string) => Promise<Response | undefined>,
    appRoot: string,
): Promise<Response> {
    try {
        return await navigation.handle({ ...context, request: new Request(context.request, { cache: 'no-cache' }) })
    } catch {
        return await matchPrecache(`${appRoot}index.html`) ?? Response.error()
    }
}
