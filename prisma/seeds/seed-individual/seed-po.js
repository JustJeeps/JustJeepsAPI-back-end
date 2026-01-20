const { PrismaClient } = require('@prisma/client')
// import purchaseOrder_data from '../hard-code_data/purchaseOrder_data'

const prisma = new PrismaClient()

const data =  [
  {
      "id": 12,
      "created_at": "2023-04-25T18:26:15.382Z",
      "user_id": 2,
      "order_id": 82123,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 16,
              "product_sku": "BST-52584-35",
              "vendor_sku": null,
              "purchase_order_id": 12,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 134.14
          }
      ]
  },
  {
      "id": 13,
      "created_at": "2023-04-25T18:26:43.979Z",
      "user_id": 3,
      "order_id": 82122,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 17,
              "product_sku": "BOA-5146",
              "vendor_sku": null,
              "purchase_order_id": 13,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 90.75
          }
      ]
  },
  {
      "id": 14,
      "created_at": "2023-04-25T18:26:59.464Z",
      "user_id": 4,
      "order_id": 82120,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 18,
              "product_sku": "RG-100J75-B",
              "vendor_sku": null,
              "purchase_order_id": 14,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 98.79
          }
      ]
  },
  {
      "id": 15,
      "created_at": "2023-04-25T18:27:38.270Z",
      "user_id": 5,
      "order_id": 82102,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 19,
              "product_sku": "SB-97281-98",
              "vendor_sku": null,
              "purchase_order_id": 15,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 19.44
          },
          {
              "id": 20,
              "product_sku": "SB-98695",
              "vendor_sku": null,
              "purchase_order_id": 15,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 534.29
          }
      ]
  },
  {
      "id": 16,
      "created_at": "2023-04-25T18:28:44.179Z",
      "user_id": 2,
      "order_id": 82095,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 21,
              "product_sku": "JKS-JKS9615",
              "vendor_sku": null,
              "purchase_order_id": 16,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 152.56
          }
      ]
  },
  {
      "id": 17,
      "created_at": "2023-04-25T18:28:46.267Z",
      "user_id": 3,
      "order_id": 82095,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 22,
              "product_sku": "SYN-8810-02",
              "vendor_sku": null,
              "purchase_order_id": 17,
              "vendor_product_id": null,
              "quantity_purchased": 2,
              "vendor_cost": 118.93
          }
      ]
  },
  {
      "id": 18,
      "created_at": "2023-04-25T18:28:52.489Z",
      "user_id": 4,
      "order_id": 82097,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 23,
              "product_sku": "VA-00041",
              "vendor_sku": null,
              "purchase_order_id": 18,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 47.51
          }
      ]
  },
  {
      "id": 19,
      "created_at": "2023-04-25T18:29:07.265Z",
      "user_id": 5,
      "order_id": 82094,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 24,
              "product_sku": "OA-12301.07",
              "vendor_sku": null,
              "purchase_order_id": 19,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 3.73
          }
      ]
  },
  {
      "id": 20,
      "created_at": "2023-04-25T18:29:45.223Z",
      "user_id": 2,
      "order_id": 82093,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 25,
              "product_sku": "OA-18024.01",
              "vendor_sku": null,
              "purchase_order_id": 20,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 112.2
          }
      ]
  },
  {
      "id": 21,
      "created_at": "2023-04-25T18:30:06.872Z",
      "user_id": 3,
      "order_id": 82092,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 26,
              "product_sku": "KEN-80572",
              "vendor_sku": null,
              "purchase_order_id": 21,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 187.81
          },
          {
              "id": 27,
              "product_sku": "KEN-80580",
              "vendor_sku": null,
              "purchase_order_id": 21,
              "vendor_product_id": null,
              "quantity_purchased": 2,
              "vendor_cost": 210.68
          },
          {
              "id": 28,
              "product_sku": "KEN-80576",
              "vendor_sku": null,
              "purchase_order_id": 21,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 565.86
          }
      ]
  },
  {
      "id": 22,
      "created_at": "2023-04-25T18:30:37.207Z",
      "user_id": 4,
      "order_id": 82090,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 29,
              "product_sku": "ALY-11650",
              "vendor_sku": null,
              "purchase_order_id": 22,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 65.3
          }
      ]
  },
  {
      "id": 23,
      "created_at": "2023-04-25T18:30:58.480Z",
      "user_id": 5,
      "order_id": 82089,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 30,
              "product_sku": "BST-56853-17",
              "vendor_sku": null,
              "purchase_order_id": 23,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 1616.87
          }
      ]
  },
  {
      "id": 24,
      "created_at": "2023-04-25T18:31:09.506Z",
      "user_id": 2,
      "order_id": 82087,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 31,
              "product_sku": "OA-11603.01",
              "vendor_sku": null,
              "purchase_order_id": 24,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 109.24
          }
      ]
  },
  {
      "id": 25,
      "created_at": "2023-04-25T18:31:20.156Z",
      "user_id": 3,
      "order_id": 82086,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 32,
              "product_sku": "ZAM-Z_SGW_EXT",
              "vendor_sku": null,
              "purchase_order_id": 25,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 31.35
          }
      ]
  },
  {
      "id": 26,
      "created_at": "2023-04-25T18:31:36.333Z",
      "user_id": 4,
      "order_id": 82084,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 33,
              "product_sku": "DV8-LPBR-03",
              "vendor_sku": null,
              "purchase_order_id": 26,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 80.83
          }
      ]
  },
  {
      "id": 27,
      "created_at": "2023-04-25T18:33:32.918Z",
      "user_id": 5,
      "order_id": 82082,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 34,
              "product_sku": "OA-12004.12",
              "vendor_sku": null,
              "purchase_order_id": 27,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 143.37
          },
          {
              "id": 35,
              "product_sku": "OA-12029.17",
              "vendor_sku": null,
              "purchase_order_id": 27,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 299.22
          },
          {
              "id": 36,
              "product_sku": "OA-12004.11",
              "vendor_sku": null,
              "purchase_order_id": 27,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 143.37
          }
      ]
  },
  {
      "id": 28,
      "created_at": "2023-04-25T18:34:04.906Z",
      "user_id": 2,
      "order_id": 82081,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 37,
              "product_sku": "OA-11212.02",
              "vendor_sku": null,
              "purchase_order_id": 28,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 61.09
          },
          {
              "id": 38,
              "product_sku": "OA-16529.08",
              "vendor_sku": null,
              "purchase_order_id": 28,
              "vendor_product_id": null,
              "quantity_purchased": 2,
              "vendor_cost": 2.19
          },
          {
              "id": 39,
              "product_sku": "OA-16711.01",
              "vendor_sku": null,
              "purchase_order_id": 28,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 6.23
          },
          {
              "id": 40,
              "product_sku": "OA-16710.01",
              "vendor_sku": null,
              "purchase_order_id": 28,
              "vendor_product_id": null,
              "quantity_purchased": 2,
              "vendor_cost": 4.98
          }
      ]
  },
  {
      "id": 29,
      "created_at": "2023-04-25T18:34:58.634Z",
      "user_id": 3,
      "order_id": 82079,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 41,
              "product_sku": "KEN-70012",
              "vendor_sku": null,
              "purchase_order_id": 29,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 39.71
          }
      ]
  },
  {
      "id": 30,
      "created_at": "2023-04-25T18:35:00.961Z",
      "user_id": 4,
      "order_id": 82079,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 42,
              "product_sku": "LUL-LLR-D044",
              "vendor_sku": null,
              "purchase_order_id": 30,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 28.2
          }
      ]
  },
  {
      "id": 31,
      "created_at": "2023-04-25T18:35:11.169Z",
      "user_id": 5,
      "order_id": 82076,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 43,
              "product_sku": "NOC-GBX45",
              "vendor_sku": null,
              "purchase_order_id": 31,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 179.11
          }
      ]
  },
  {
      "id": 32,
      "created_at": "2023-04-25T18:35:31.519Z",
      "user_id": 2,
      "order_id": 82202,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 44,
              "product_sku": "OA-17613.12",
              "vendor_sku": null,
              "purchase_order_id": 32,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 258.67
          }
      ]
  },
  {
      "id": 33,
      "created_at": "2023-04-25T18:36:19.827Z",
      "user_id": 2,
      "order_id": 82197,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 45,
              "product_sku": "RR-11210.32",
              "vendor_sku": null,
              "purchase_order_id": 33,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 65.31
          }
      ]
  },
  {
      "id": 34,
      "created_at": "2023-04-25T18:36:22.279Z",
      "user_id": 3,
      "order_id": 82198,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 46,
              "product_sku": "QKE-QTE993",
              "vendor_sku": null,
              "purchase_order_id": 34,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 440.26
          }
      ]
  },
  {
      "id": 35,
      "created_at": "2023-04-25T18:36:38.385Z",
      "user_id": 4,
      "order_id": 82195,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 47,
              "product_sku": "OA-16526.03",
              "vendor_sku": null,
              "purchase_order_id": 35,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 7.48
          }
      ]
  },
  {
      "id": 36,
      "created_at": "2023-04-25T18:36:58.229Z",
      "user_id": 5,
      "order_id": 82214,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 48,
              "product_sku": "LAO-014-GEN2",
              "vendor_sku": null,
              "purchase_order_id": 36,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 1074.42
          }
      ]
  },
  {
      "id": 37,
      "created_at": "2023-04-25T18:37:17.101Z",
      "user_id": 2,
      "order_id": 82215,
      "vendor_id": 2,
      "purchaseOrderLineItems": [
          {
              "id": 49,
              "product_sku": "FBF-J1050",
              "vendor_sku": null,
              "purchase_order_id": 37,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 807.3
          }
      ]
  },
  {
      "id": 38,
      "created_at": "2023-04-25T18:37:19.218Z",
      "user_id": 3,
      "order_id": 82215,
      "vendor_id": 3,
      "purchaseOrderLineItems": [
          {
              "id": 50,
              "product_sku": "RR-12975.49",
              "vendor_sku": null,
              "purchase_order_id": 38,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 64.12
          }
      ]
  },
  {
      "id": 39,
      "created_at": "2023-04-25T18:37:27.865Z",
      "user_id": 4,
      "order_id": 82217,
      "vendor_id": 1,
      "purchaseOrderLineItems": [
          {
              "id": 51,
              "product_sku": "BST-52454-35",
              "vendor_sku": null,
              "purchase_order_id": 39,
              "vendor_product_id": null,
              "quantity_purchased": 1,
              "vendor_cost": 825.37
          }
      ]
  }
]

async function main() {
  for (const purchaseOrderData of data) {
    const purchaseOrderLineItemsData = purchaseOrderData.purchaseOrderLineItems
    delete purchaseOrderData.purchaseOrderLineItems
    // console.log(purchaseOrderData)

    const purchaseOrder = await prisma.purchaseOrder.create({
      data: purchaseOrderData,
    })

    const purchaseOrderLineItems = purchaseOrderLineItemsData.map((lineItemData) => {
      return {
        ...lineItemData,
        purchase_order_id: purchaseOrder.id,
      }
    })
    console.log(purchaseOrderLineItems)
    await prisma.purchaseOrderLineItem.createMany({
      data: purchaseOrderLineItems,
    })
  }
  console.log(`Created ${data.length} purchase orders!`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })



