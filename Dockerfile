FROM node:12
WORKDIR /app
COPY package.json /app/package.json 
COPY server.js /app/server.js
COPY public/ /app/public/
RUN yarn config set registry https://registry.npm.taobao.org -g
RUN export NODE_ENV=production
RUN yarn 
EXPOSE 8080
CMD [ "yarn","serve" ]
