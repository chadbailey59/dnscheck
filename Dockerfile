FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends dnsutils && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY app.py .
COPY probes.db .
EXPOSE 8765
CMD ["python", "app.py", "--host", "0.0.0.0", "--port", "8765"]
