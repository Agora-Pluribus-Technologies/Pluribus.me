export async function onRequest(context) {
    return new Response("Hello, World!", {
        headers: {"Content-Type": "text/plain"},
    });
}