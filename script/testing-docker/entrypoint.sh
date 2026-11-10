#!/bin/bash

# Exit if any command fails
set -e

cd /app

npm run test:setup
npm run test:unit
npm run test:script

echo '-------------------'
echo 'All tests passed 🎉'
echo '-------------------'
