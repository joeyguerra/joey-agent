NAME=joey-agent
VERSION=$(shell node -p "require('./package.json').version")
IMAGE=local/$(NAME):$(VERSION)
SSH_KEY=~/.ssh/id_ed25519_claude_agent
LIMA_INSTANCE?=k3s
KUBE_CONTEXT?=k3s-local
KUBE_NAMESPACE?=default

.PHONY: build deploy ssh login teardown

build:
	npm version patch --no-git-tag-version
	$(eval VERSION=$(shell node -p "require('./package.json').version"))
	$(eval IMAGE=local/$(NAME):$(VERSION))
	sed -i '' -e "s|local/$(NAME):[0-9]*\.[0-9]*\.[0-9]*|local/$(NAME):$(VERSION)|g" charts/web/templates/deployment.yaml
	docker build -t $(IMAGE) .
	docker save $(IMAGE) | limactl shell $(LIMA_INSTANCE) -- sudo k3s ctr images import -

deploy: build
	kubectl config use-context $(KUBE_CONTEXT)
	kubectl apply -f charts/web/templates/deployment.yaml -n $(KUBE_NAMESPACE)
	kubectl rollout status deployment/$(NAME) -n $(KUBE_NAMESPACE) --timeout=120s
	@echo ""
	@echo "Pod is ready. Connect with:"
	@echo "  make ssh"

ssh:
	ssh-keygen -R '[localhost]:2222' 2>/dev/null || true
	@pkill -f 'port-forward.*$(NAME).*2222' 2>/dev/null || true
	kubectl port-forward deployment/$(NAME) 2222:2222 -n $(KUBE_NAMESPACE) &
	@sleep 1
	ssh -i $(SSH_KEY) -p 2222 -o StrictHostKeyChecking=no claude@localhost; pkill -f 'port-forward.*$(NAME).*2222' 2>/dev/null || true

# One-time setup: authenticate Claude inside the pod
# Run this after first deploy, then credentials persist on the PVC
login:
	ssh-keygen -R '[localhost]:2222' 2>/dev/null || true
	@pkill -f 'port-forward.*$(NAME).*2222' 2>/dev/null || true
	kubectl port-forward deployment/$(NAME) 2222:2222 -n $(KUBE_NAMESPACE) &
	@sleep 1
	ssh -i $(SSH_KEY) -p 2222 -o StrictHostKeyChecking=no -t claude@localhost 'bash -lc "claude auth login"'; pkill -f 'port-forward.*$(NAME).*2222' 2>/dev/null || true

teardown:
	kubectl config use-context $(KUBE_CONTEXT)
	kubectl delete -f charts/web/templates/deployment.yaml -n $(KUBE_NAMESPACE)
