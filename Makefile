# Build and test entry points. Organisation standard: use these targets,
# not raw npm/jest/vitest commands.

# Pass ARGS to narrow a run, e.g. make test-backend ARGS=tests/apiTokens.test.js
.PHONY: install test test-backend test-frontend

install:
	npm install --prefix backend
	npm install --prefix frontend

test: test-backend test-frontend

test-backend:
	cd backend && npm test -- $(ARGS)

test-frontend:
	cd frontend && npm test -- $(ARGS)
