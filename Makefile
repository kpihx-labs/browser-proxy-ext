SHELL := /bin/zsh

.PHONY: help install build test typecheck check clean git-push push release

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

git-push: ## Push the current branch to GitHub and GitLab
	@branch="$$(git branch --show-current)"; git push github "$$branch"; git push gitlab "$$branch"

push: git-push ## Push to GitHub and GitLab

release: check build push ## Verify, bundle, and push the release
