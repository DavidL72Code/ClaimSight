FROM python:3.10-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PORT=7860
ENV APP_ENV=production
ENV DEBUG=false
ENV ENABLE_API_DOCS=false
ENV INSTALL_SAM2=1
ENV SEGMENTATION_PROVIDER=sam2
ENV SAM2_MODEL_ID=facebook/sam2-hiera-tiny

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt requirements-sam2.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
    && if [ "$INSTALL_SAM2" = "1" ]; then pip install --no-cache-dir -r requirements-sam2.txt; fi

COPY app ./app

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
