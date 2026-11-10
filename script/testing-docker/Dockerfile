FROM ubuntu:latest

RUN apt-get -y update
RUN apt-get -y install git make g++ curl libsecret-1-dev libnss3 libdbus-1-3 libatk1.0 libatk-bridge2.0-dev libcups2-dev libdrm-dev libgtk-3-dev libasound2-dev

# Install Node.js
RUN curl -sL https://deb.nodesource.com/setup_24.x | bash -
RUN apt-get -y install nodejs

# Disable git dubious ownership checks
RUN echo "[safe]\n\tdirectory = *" >> ~/.gitconfig
RUN cp ~/.gitconfig /etc/gitconfig

# Set PATH in profile.d (required for get-shell-env-test.ts)
RUN echo 'export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' > /etc/profile.d/set-path.sh

COPY ./entrypoint.sh /entrypoint.sh

CMD ["/entrypoint.sh"]
