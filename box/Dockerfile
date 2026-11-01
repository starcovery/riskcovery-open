FROM node:24.22.1-bookworm-slim@sha256:be8204d4bd327363357f532187b752ff62759c31bedf98e9e18fc08c9cbd605c

ARG CLAUDE_CODE_VERSION=2.1.316

RUN apt-get update -qq \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends ca-certificates sudo \
  && useradd --create-home --home-dir /home/user --shell /bin/bash user \
  && printf 'user ALL=(ALL) NOPASSWD:ALL\n' > /etc/sudoers.d/user \
  && chmod 0440 /etc/sudoers.d/user \
  && npm install --global --no-fund --no-audit "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

COPY model-relay.mts /opt/model-relay.mts

USER user

WORKDIR /home/user

CMD ["sleep", "infinity"]
