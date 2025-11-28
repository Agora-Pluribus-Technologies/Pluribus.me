from http.server import SimpleHTTPRequestHandler, HTTPServer

class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

if __name__ == '__main__':
    print("Starting server")
    httpd = HTTPServer(('localhost', 8080), Handler)
    httpd.serve_forever()
