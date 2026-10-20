# Scrambled into a static binary outside the image; scratch has no shell,
# package manager or network - the target host may have none of them either.
FROM scratch
ARG TARGETARCH
COPY out/sessiond-linux-${TARGETARCH} /sessiond
ENTRYPOINT ["/sessiond"]
