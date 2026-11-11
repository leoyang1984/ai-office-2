FROM docker.io/library/node@sha256:ba6b7d0ee561d9d49deb99e2b93c98632cc287b6cca1a6b18d66127054efa4dc

WORKDIR /opt/office-worker
COPY --from=dsh_dependencies /node_modules ./node_modules
COPY workers/dsh-worker/bridge.mjs ./bridge.mjs
USER 1000:1000
ENTRYPOINT ["node", "/opt/office-worker/bridge.mjs"]
