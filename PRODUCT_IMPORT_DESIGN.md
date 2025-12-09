# Product Import Process - Design Document

## Overview

This document describes the high-level design for importing new products into the Dobutsu Stationery inventory system using photo-based scanning with LLM assistance.

## Background

When new orders are delivered to Dobutsu, employees need an efficient way to process incoming inventory. The current manual entry process is time-consuming and error-prone. This design introduces an automated workflow that leverages photography and AI to streamline the process of adding new products to inventory.

## Process Flow

### 1. Physical Receipt

When a new order arrives at Dobutsu:
- The order includes a packing list or invoice enumerating items with JAN (Japanese Article Number) codes
- Employees prepare to photograph each received item
- Photos are organized in a dedicated Google Photos album for processing

### 2. Photo Capture Workflow

Employees follow a structured photography protocol:
- **First Photo**: Back of packaging showing the JAN barcode
- **Subsequent Photos**: Detail shots of the same product (front, sides, special features, etc.)
- **Next Product**: Another JAN barcode photo signals the start of a new product sequence
- Photos are uploaded to Google Photos in chronological order

This sequential pattern establishes clear product boundaries in the photo stream.

### 3. Automated Photo Scanning

The system processes photos from the Google Photos album in chronological order:
- **Barcode Detection**: Identifies photos containing JAN codes
- **Product Grouping**: Associates subsequent detail photos with the most recent JAN code
- **LLM Processing**: For each product group, the system:
  - Extracts the JAN code using optical character recognition or computer vision
  - Analyzes all photos in the product group (packaging, details, etc.)
  - Generates a playful, engaging product description suitable for the Dobutsu Stationery brand
  - Creates an inventory receipt entry with the extracted information

The scanning process is fully automated, requiring no human intervention during the image processing phase.

### 4. Review and Classification

After automated scanning, employees review each imported item and make classification decisions:

#### Option 1: Merge with Existing Listing
- The product already exists in inventory under a different entry
- User merges the new receipt with the existing product listing
- Inventory quantities are combined
- Duplicate entries are eliminated

#### Option 2: Create Subtype
- The product is a variant of an existing product (e.g., different color, size, or packaging)
- User designates it as a subtype of the parent product
- Maintains separate inventory tracking while associating with the base product
- Useful for products with multiple SKUs under the same family

#### Option 3: Create New Listing
- The product is entirely new to the inventory
- User confirms creation of a new, independent product listing
- System generates a unique inventory entry
- Product becomes searchable and available for order fulfillment

## Key Design Principles

### Separation of Concerns
- **Photo Capture**: Handled by employees with mobile devices or cameras
- **Photo Storage**: Managed by Google Photos for reliability and accessibility
- **Automated Processing**: Performed by the system without manual data entry
- **Human Review**: Reserved for classification decisions, not data entry

### Error Recovery
- Photos can be reprocessed if scanning fails
- Employees can manually override extracted information if needed
- Misclassified products can be reclassified after import

### Scalability
- Supports processing multiple products in a single photo session
- Can handle varying numbers of detail photos per product
- Works with different photography styles and lighting conditions

### Brand Consistency
- LLM-generated descriptions maintain the Dobutsu Stationery brand voice
- Descriptions are playful and engaging, suitable for customer-facing use
- Human review ensures quality control

## User Roles

### Warehouse Staff
- Photograph incoming inventory
- Upload photos to designated Google Photos album
- Maintain sequential order (JAN photo first, details following)

### Inventory Managers
- Review automatically processed products
- Make classification decisions (merge/subtype/new)
- Verify product information accuracy
- Handle edge cases and exceptions

### System Administrators
- Monitor processing success rates
- Troubleshoot failed imports
- Maintain Google Photos integration
- Configure LLM parameters

## Integration Points

### Google Photos API
- Read-only access to designated album
- Retrieve photos in chronological order
- Support for batch processing
- Handle API rate limits gracefully

### LLM Service
- Send product photos for analysis
- Extract JAN codes from barcode images
- Generate product descriptions from visual analysis
- Maintain consistent brand voice through prompt engineering

### Inventory System
- Create receipt entries for incoming products
- Support merge operations for duplicate detection
- Handle subtype relationships
- Maintain inventory quantity tracking

## Privacy and Security

- Google Photos access limited to designated business accounts
- Product photos contain no personally identifiable information
- LLM processing uses business-appropriate content policies
- Inventory data access restricted by role-based permissions
- Audit logs track all classification decisions and changes

## Summary

This design introduces an efficient, photo-based workflow for importing new inventory into the Dobutsu Stationery system. By combining structured photography, automated LLM processing, and human review for classification decisions, the process significantly reduces manual data entry while maintaining accuracy and brand consistency. The clear separation between automated extraction and human decision-making ensures both efficiency and quality control.

## Related Documents

*   [Order Import Design](ORDER_IMPORT_DESIGN.md): Design for importing inventory quantities from spreadsheets (invoices/packing lists).
