.PHONY: dev server-dev web-dev simlab test test-server test-ts lint vectors-test

## dev: run API server and web client dev servers together
dev:
	$(MAKE) -j2 server-dev web-dev

server-dev:
	cd server && go run ./cmd/runad

web-dev:
	npm run dev -w web

## simlab: run the simulator dev server
simlab:
	npm run dev -w simlab

test: test-server test-ts

test-server:
	cd server && go test ./...

test-ts:
	npm run test --workspaces --if-present

lint:
	cd server && go vet ./...
	npm run typecheck --workspaces --if-present

## vectors-test: cross-implementation protocol vectors (subset of test; kept as
## a named target so CI can gate on it explicitly)
vectors-test:
	cd server && go test ./... -run Vector
	npm run test -w packages/core -- --run vectors
