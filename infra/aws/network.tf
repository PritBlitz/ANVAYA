data "aws_availability_zones" "available" {
  state = "available"
}

locals {
  prefix     = "${var.name}-${var.environment}"
  production = var.environment == "production"
  azs        = slice(data.aws_availability_zones.available.names, 0, 2)

  # /20 per subnet: 0-1 public, 2-3 application, 4-5 execution, 6-7 firewall.
  public_cidrs    = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i)]
  app_cidrs       = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 2)]
  execution_cidrs = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 4)]
  firewall_cidrs  = [for i in range(2) : cidrsubnet(var.vpc_cidr, 4, i + 6)]

  nat_count = local.production ? 2 : 1
}

resource "aws_vpc" "main" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags                 = { Name = local.prefix }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
  tags   = { Name = local.prefix }
}

resource "aws_subnet" "public" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.public_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.prefix}-public-${local.azs[count.index]}", Tier = "public" }
}

# ECS services, RDS, Redis, inference hosts. No public IPs.
resource "aws_subnet" "app" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.app_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.prefix}-app-${local.azs[count.index]}", Tier = "application" }
}

# gVisor execution hosts (SECURITY §7): egress only through the Network Firewall allowlist.
resource "aws_subnet" "execution" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.execution_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.prefix}-execution-${local.azs[count.index]}", Tier = "execution" }
}

resource "aws_subnet" "firewall" {
  count             = 2
  vpc_id            = aws_vpc.main.id
  cidr_block        = local.firewall_cidrs[count.index]
  availability_zone = local.azs[count.index]
  tags              = { Name = "${local.prefix}-firewall-${local.azs[count.index]}", Tier = "firewall" }
}

resource "aws_eip" "nat" {
  count  = local.nat_count
  domain = "vpc"
  tags   = { Name = "${local.prefix}-nat-${count.index}" }
}

resource "aws_nat_gateway" "main" {
  count         = local.nat_count
  allocation_id = aws_eip.nat[count.index].id
  subnet_id     = aws_subnet.public[count.index].id
  tags          = { Name = "${local.prefix}-nat-${count.index}" }
  depends_on    = [aws_internet_gateway.main]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
  tags = { Name = "${local.prefix}-public" }
}

resource "aws_route_table_association" "public" {
  count          = 2
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

resource "aws_route_table" "app" {
  count  = 2
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[min(count.index, local.nat_count - 1)].id
  }
  tags = { Name = "${local.prefix}-app-${local.azs[count.index]}" }
}

resource "aws_route_table_association" "app" {
  count          = 2
  subnet_id      = aws_subnet.app[count.index].id
  route_table_id = aws_route_table.app[count.index].id
}

# Firewall subnets forward inspected traffic to NAT.
resource "aws_route_table" "firewall" {
  count  = 2
  vpc_id = aws_vpc.main.id
  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.main[min(count.index, local.nat_count - 1)].id
  }
  tags = { Name = "${local.prefix}-firewall-${local.azs[count.index]}" }
}

resource "aws_route_table_association" "firewall" {
  count          = 2
  subnet_id      = aws_subnet.firewall[count.index].id
  route_table_id = aws_route_table.firewall[count.index].id
}

# Execution subnets: the default route goes to the firewall endpoint in the same AZ.
resource "aws_route_table" "execution" {
  count  = 2
  vpc_id = aws_vpc.main.id
  tags   = { Name = "${local.prefix}-execution-${local.azs[count.index]}" }
}

resource "aws_route" "execution_egress" {
  count                  = 2
  route_table_id         = aws_route_table.execution[count.index].id
  destination_cidr_block = "0.0.0.0/0"
  vpc_endpoint_id        = local.firewall_endpoints[local.azs[count.index]]
}

resource "aws_route_table_association" "execution" {
  count          = 2
  subnet_id      = aws_subnet.execution[count.index].id
  route_table_id = aws_route_table.execution[count.index].id
}

# Keep S3 traffic (artifacts, image layers) on the AWS network.
resource "aws_vpc_endpoint" "s3" {
  vpc_id            = aws_vpc.main.id
  service_name      = "com.amazonaws.${var.region}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = concat(aws_route_table.app[*].id, aws_route_table.execution[*].id)
  tags              = { Name = "${local.prefix}-s3" }
}

resource "aws_flow_log" "vpc" {
  vpc_id               = aws_vpc.main.id
  traffic_type         = "REJECT"
  log_destination_type = "cloud-watch-logs"
  log_destination      = aws_cloudwatch_log_group.flow.arn
  iam_role_arn         = aws_iam_role.flow_logs.arn
}
