const fs = require('fs');
const path = require('path');
const YAML = require('yaml');
const swaggerUi = require('swagger-ui-express');

// OpenAPI spec is maintained by hand in openapi.yaml next to this file.
const spec = YAML.parse(fs.readFileSync(path.join(__dirname, 'openapi.yaml'), 'utf8'));

module.exports = { serve: swaggerUi.serve, setup: swaggerUi.setup(spec), spec };
