set shell := ["bash", "-euo", "pipefail", "-c"]

remote_host := env_var_or_default("REMOTE_HOST", "gemini.local")
remote_dir := env_var_or_default("REMOTE_DIR", "/home/chad/server/public/dnscheck")
app_image := env_var_or_default("APP_IMAGE", "dnscheck:latest")
contributor_image := env_var_or_default("CONTRIBUTOR_IMAGE", "dnscheck-contributor:latest")
render_service_id := env_var_or_default("RENDER_SERVICE_ID", "srv-d8knqlj7uimc73b8uof0")

default:
    @just --list

deploy: deploy-gemini deploy-render
    @echo "Deploy complete."

deploy-no-cache: deploy-gemini-no-cache deploy-render-clear-cache
    @echo "Deploy complete."

deploy-gemini:
    @echo "Building {{app_image}} locally..."
    docker build -t "{{app_image}}" .
    @echo "Building {{contributor_image}} locally..."
    docker build --target contributor -t "{{contributor_image}}" .
    @echo "Loading images on {{remote_host}}..."
    docker save "{{app_image}}" "{{contributor_image}}" | ssh "{{remote_host}}" docker load
    @echo "Restarting dnscheck on {{remote_host}}..."
    ssh "{{remote_host}}" "cd '{{remote_dir}}' && docker compose up -d --no-build --force-recreate"
    @echo "Recent remote logs:"
    ssh "{{remote_host}}" "docker logs dnscheck --tail 20 && docker logs dnscheck-contributor --tail 20"

deploy-gemini-no-cache:
    @echo "Building {{app_image}} locally without cache..."
    docker build --no-cache -t "{{app_image}}" .
    @echo "Building {{contributor_image}} locally without cache..."
    docker build --no-cache --target contributor -t "{{contributor_image}}" .
    @echo "Loading images on {{remote_host}}..."
    docker save "{{app_image}}" "{{contributor_image}}" | ssh "{{remote_host}}" docker load
    @echo "Restarting dnscheck on {{remote_host}}..."
    ssh "{{remote_host}}" "cd '{{remote_dir}}' && docker compose up -d --no-build --force-recreate"
    @echo "Recent remote logs:"
    ssh "{{remote_host}}" "docker logs dnscheck --tail 20 && docker logs dnscheck-contributor --tail 20"

deploy-render:
    @echo "Triggering Render deploy for dnscheck..."
    render deploys create "{{render_service_id}}" --confirm --wait

deploy-render-clear-cache:
    @echo "Triggering Render deploy for dnscheck with cleared cache..."
    render deploys create "{{render_service_id}}" --clear-cache --confirm --wait
