SHELL := /bin/zsh

.PHONY: help install build test typecheck check clean

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "%-12s %s\n", $$1, $$2}'

install: ## Install Bun dependencies
	bun install

build: ## Bundle the extension
	bun run build

test: ## Run unit tests
	bun test

typecheck: ## Type-check TypeScript
	bun run typecheck

check: ## Type-check and test
	bun run check

clean: ## Remove generated bundle
	rm -rf dist
