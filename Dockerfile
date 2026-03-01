FROM python:3.11-slim

WORKDIR /app

# Copy dependency manifest first for layer caching
COPY pyproject.toml .
COPY app/ app/

# Install the package (reads pyproject.toml)
RUN pip install --no-cache-dir -e .

# CRITICAL: uvicorn must run from inside app/ so Python can find the
# orion_orchestrator module. Running from /app would cause ModuleNotFoundError.
WORKDIR /app/app

EXPOSE 8080

# Cloud Run sets PORT automatically; default to 8080
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT:-8080}
