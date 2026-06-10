// Collect requestfinished / requestfailed events from a harness-wrapped page or
// context (backed by the NetworkEventBridge) into `requests`, classifying each
// the same way the DuckDuckGo helper does:
//   - requestfinished      -> 'redirected' if it was redirected, else 'allowed'
//   - requestfailed        -> 'blocked' for aborted/blocked errors, else 'failed'
//
// Returns a cleanup function that removes the listeners.
export function logPageRequests(target, requests, filter = () => true) {
    const record = (request, status, reason) => {
        const entry = {
            url: request.url(),
            method: request.method(),
            type: request.resourceType(),
            status,
        };
        if (reason) entry.reason = reason;
        if (filter(entry)) requests.push(entry);
    };

    const onFinished = (request) => {
        record(request, request.redirectedTo() ? 'redirected' : 'allowed');
    };
    const onFailed = (request) => {
        const errorText = request.failure()?.errorText || 'unknown';
        const blocked = errorText === 'net::ERR_ABORTED' || errorText === 'net::ERR_BLOCKED_BY_CLIENT';
        record(request, blocked ? 'blocked' : 'failed', errorText);
    };

    target.on('requestfinished', onFinished);
    target.on('requestfailed', onFailed);

    return () => {
        target.off('requestfinished', onFinished);
        target.off('requestfailed', onFailed);
    };
}
