from django.conf import settings


class ContentSecurityPolicyMiddleware:
    """Agrega la cabecera Content-Security-Policy (o su versión Report-Only) a todas las respuestas."""

    def __init__(self, get_response):
        self.get_response = get_response
        self.header = "Content-Security-Policy-Report-Only" if settings.CSP_REPORT_ONLY else "Content-Security-Policy"

    def __call__(self, request):
        response = self.get_response(request)
        if settings.CSP and self.header not in response:
            response[self.header] = settings.CSP
        return response
